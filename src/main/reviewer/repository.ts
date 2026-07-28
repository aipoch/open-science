import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import type { Finding as PrismaFinding, PrismaClient, Review as PrismaReview } from '@prisma/client'

import type {
  CheckStatus,
  CreateReviewInput,
  FindingLocator,
  FindingResolution,
  NewCheck,
  Review,
  ReviewCheck,
  ReviewFindingDisposition,
  ReviewFindingDispositionOutcome,
  ReviewFindingDispositionTrigger,
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
type ReviewClient = Pick<
  PrismaClient,
  | 'review'
  | 'finding'
  | 'reviewFindingDisposition'
  | 'reviewScopeSnapshot'
  | '$executeRaw'
  | '$transaction'
>

// Resolves the Prisma client on demand so a failed initialization is not held forever (see projects/repository.ts).
type ReviewClientProvider = () => Promise<ReviewClient>

type ReviewRepositoryOptions = {
  snapshotStorageRoot?: string
  createId?: () => string
  now?: () => Date
}

type CommitFindingDispositionInput = {
  eventId?: string
  reviewId: string
  sourceFindingId: string
  causeReviewId?: string
  trigger: ReviewFindingDispositionTrigger
  outcome: ReviewFindingDispositionOutcome
  note?: string
  assessedArtifactVersionId?: string
}

const stableJson = (value: unknown): string => {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize)
    if (typeof entry !== 'object' || entry === null) return entry
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return JSON.stringify(canonicalize(value))
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const resolveSnapshotStorageKey = (root: string, key: string): string => {
  const candidate = resolve(root, ...key.split('/'))
  const fromRoot = relative(resolve(root), candidate)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Invalid Review scope snapshot storage key.')
  }
  return candidate
}

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
    artifactBindingState:
      row.artifactBindingState === 'scope_validated' ? 'scope_validated' : 'legacy_unverified',
    sortIndex: row.sortIndex,
    // Default to 0 for rows written before the reflagCount column was added (issue 15 migration guard).
    reflagCount: row.reflagCount ?? 0
  }
}

const toFindingDisposition = (row: {
  id: string
  sourceFindingId: string
  causeReviewId: string | null
  sequence: number
  trigger: string
  outcome: string
  note: string | null
  assessedArtifactVersionId: string | null
  createdAt: Date
}): ReviewFindingDisposition => ({
  id: row.id,
  sourceFindingId: row.sourceFindingId,
  causeReviewId: row.causeReviewId ?? undefined,
  sequence: row.sequence,
  trigger: row.trigger as ReviewFindingDispositionTrigger,
  outcome: row.outcome as ReviewFindingDispositionOutcome,
  note: row.note ?? undefined,
  assessedArtifactVersionId: row.assessedArtifactVersionId ?? undefined,
  createdAt: row.createdAt.getTime()
})

// Owns Review/check reads/writes. The client is resolved lazily per call so schema-ensure failures can
// recover (see projects/repository.ts). Reviews live in SQLite while the transcript stays in session JSON;
// cross-store cleanup is done here by deleting review rows (and their checks) by session/project id.
class ReviewRepository {
  constructor(
    private readonly getClient: ReviewClientProvider,
    private readonly options: ReviewRepositoryOptions = {}
  ) {}

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

    if (input.scopeSnapshot && this.options.snapshotStorageRoot) {
      try {
        await this.persistScopeSnapshot(toReview(row), input.scopeSnapshot)
      } catch (error) {
        await client.review
          .update({
            where: { id: row.id },
            data: {
              lifecycle: 'error',
              outcome: null,
              errorMessage: error instanceof Error ? error.message : String(error)
            }
          })
          .catch(() => undefined)
        throw error
      }
    }

    return toReview(row)
  }

  private async persistScopeSnapshot(
    review: Review,
    blocks: NonNullable<CreateReviewInput['scopeSnapshot']>
  ): Promise<void> {
    const root = this.options.snapshotStorageRoot
    if (!root) throw new Error('Review scope snapshot storage is not configured.')

    const client = await this.getClient()
    const snapshotId = (this.options.createId ?? randomUUID)()
    const createdAt = (this.options.now ?? (() => new Date()))()
    const sessionSegment = encodeURIComponent(review.sessionId)
    const projectSegment = encodeURIComponent(review.projectId)
    const storageKey = [
      'artifacts',
      projectSegment,
      sessionSegment,
      '.provenance',
      'review-scope-snapshots',
      `${snapshotId}.json`
    ].join('/')
    const snapshotJson = stableJson({
      schemaVersion: 2,
      snapshotId,
      reviewId: review.id,
      projectId: review.projectId,
      sessionId: review.sessionId,
      scope: review.scope,
      agentFrameId: review.scope.agentFrameId,
      messageBranchId: review.scope.messageBranchId,
      blocks,
      createdAt: createdAt.toISOString()
    })
    const checksum = sha256(snapshotJson)
    const targetPath = resolveSnapshotStorageKey(root, storageKey)
    const tempPath = `${targetPath}.${snapshotId}.tmp`

    await client.reviewScopeSnapshot.create({
      data: {
        id: snapshotId,
        projectId: review.projectId,
        sessionId: review.sessionId,
        reviewId: review.id,
        scopeTurnMessageId: review.scope.turnMessageId,
        state: 'staging',
        snapshotJson,
        checksum,
        storageKey,
        schemaVersion: 2,
        blockCount: blocks.length,
        createdAt
      }
    })

    try {
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(tempPath, snapshotJson, { encoding: 'utf8', flag: 'wx' })
      await rename(tempPath, targetPath)
      await client.reviewScopeSnapshot.update({
        where: { reviewId: review.id },
        data: { state: 'ready' }
      })
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
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
      const review = await tx.review.findUnique({ where: { id: reviewId } })
      if (!review) throw new Error(`Review not found: ${reviewId}`)
      const scope = parseJson<TurnScope>(review.scope, EMPTY_SCOPE(review.turnMessageId))
      for (const check of checks) {
        if (
          check.artifactVersionId &&
          !scope.artifactVersionIds.includes(check.artifactVersionId)
        ) {
          throw new Error(
            `Artifact Version ${check.artifactVersionId} is not in Review ${reviewId} scope.`
          )
        }
      }
      await tx.finding.createMany({
        data: checks.map((check, index) => ({
          reviewId,
          status: check.status,
          resolution: check.resolution ?? 'open',
          claim: check.claim,
          evidence: check.evidence,
          locator: JSON.stringify(check.locator ?? {}),
          artifactVersionId: check.artifactVersionId ?? null,
          artifactBindingState: check.artifactVersionId ? 'scope_validated' : 'legacy_unverified',
          sortIndex: check.sortIndex ?? index
        }))
      })
      await touchReview(tx, reviewId)
    })
  }

  // Commits one scoped re-review submission behind a single interface. Tracked sourceFindingId
  // entries are immutable assessments of existing Findings, never new Finding rows; untracked checks
  // are newly discovered Findings. Review completion and every materialized disposition commit in the
  // same SQLite transaction, so a malformed item cannot leave a partially applied audit result.
  async commitScopedSubmission(input: {
    reviewId: string
    checks: NewCheck[]
    expectedSourceFindingIds: string[]
    outcome: ReviewOutcome
    reviewerLog?: ReviewerLogEntry[]
  }): Promise<ReviewWithChecks> {
    if (input.checks.length === 0) {
      throw new Error('A completed Review submission requires at least one explicit check.')
    }
    const trackedFindingIds = input.checks.flatMap((check) =>
      check.sourceFindingId ? [check.sourceFindingId] : []
    )
    const expectedFindingIds = input.expectedSourceFindingIds
    if (new Set(expectedFindingIds).size !== expectedFindingIds.length) {
      throw new Error('Expected tracked Finding ids must be unique.')
    }
    if (new Set(trackedFindingIds).size !== trackedFindingIds.length) {
      throw new Error('A tracked Finding may only be assessed once in a Review submission.')
    }
    const expectedSet = new Set(expectedFindingIds)
    const submittedSet = new Set(trackedFindingIds)
    if (
      expectedSet.size !== submittedSet.size ||
      [...expectedSet].some((findingId) => !submittedSet.has(findingId))
    ) {
      throw new Error('Review submission must assess the exact expected tracked Finding set.')
    }

    const client = await this.getClient()
    const ownership = await client.$transaction(async (tx) => {
      const assessmentReview = await tx.review.findUnique({ where: { id: input.reviewId } })
      if (!assessmentReview) throw new Error(`Review not found: ${input.reviewId}`)
      if (assessmentReview.lifecycle !== 'running') {
        throw new Error(`Review submission is already terminal: ${input.reviewId}`)
      }
      const assessmentScope = parseJson<TurnScope>(
        assessmentReview.scope,
        EMPTY_SCOPE(assessmentReview.turnMessageId)
      )
      for (const check of input.checks) {
        if (
          check.artifactVersionId &&
          !assessmentScope.artifactVersionIds.includes(check.artifactVersionId)
        ) {
          throw new Error(
            `Artifact Version ${check.artifactVersionId} is not in Review ${input.reviewId} scope.`
          )
        }
      }

      const newChecks = input.checks.filter((check) => !check.sourceFindingId)
      if (newChecks.length > 0) {
        await tx.finding.createMany({
          data: newChecks.map((check, index) => ({
            reviewId: input.reviewId,
            status: check.status,
            resolution: check.resolution ?? 'open',
            claim: check.claim,
            evidence: check.evidence,
            locator: JSON.stringify(check.locator ?? {}),
            artifactVersionId: check.artifactVersionId ?? null,
            artifactBindingState: check.artifactVersionId ? 'scope_validated' : 'legacy_unverified',
            sortIndex: check.sortIndex ?? index
          }))
        })
      }

      const touchedSourceReviewIds = new Set<string>()
      for (const check of input.checks) {
        if (!check.sourceFindingId) continue
        const finding = await tx.finding.findUnique({ where: { id: check.sourceFindingId } })
        if (
          !finding ||
          (finding.status !== 'warn' && finding.status !== 'fail') ||
          finding.resolution !== 'open'
        ) {
          throw new Error(`Tracked Finding is unavailable: ${check.sourceFindingId}`)
        }
        const sourceReview = await tx.review.findUnique({ where: { id: finding.reviewId } })
        if (
          !sourceReview ||
          sourceReview.projectId !== assessmentReview.projectId ||
          sourceReview.sessionId !== assessmentReview.sessionId ||
          sourceReview.turnMessageId !== assessmentReview.turnMessageId
        ) {
          throw new Error('Tracked Finding belongs to another Review turn chain.')
        }
        const dispositionOutcome: ReviewFindingDispositionOutcome =
          check.status === 'pass' ? 'resolved' : 'still_open'
        const eventId = `review-disposition-${sha256(
          stableJson({
            sourceFindingId: finding.id,
            causeReviewId: assessmentReview.id,
            trigger: 'review_submission'
          })
        )}`
        const existing = await tx.reviewFindingDisposition.findUnique({ where: { id: eventId } })
        if (existing) {
          if (
            existing.sourceFindingId !== finding.id ||
            existing.causeReviewId !== assessmentReview.id ||
            existing.trigger !== 'review_submission' ||
            existing.outcome !== dispositionOutcome ||
            existing.assessedArtifactVersionId !== (check.artifactVersionId ?? null)
          ) {
            throw new Error(`Finding disposition event was reused with different data: ${eventId}`)
          }
          continue
        }
        await tx.finding.update({
          where: { id: finding.id },
          data:
            dispositionOutcome === 'still_open'
              ? { resolution: 'open', reflagCount: { increment: 1 } }
              : { resolution: 'resolved' }
        })
        const latest = await tx.reviewFindingDisposition.findFirst({
          where: { sourceFindingId: finding.id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true }
        })
        await tx.reviewFindingDisposition.create({
          data: {
            id: eventId,
            sourceFindingId: finding.id,
            causeReviewId: assessmentReview.id,
            sequence: (latest?.sequence ?? 0) + 1,
            trigger: 'review_submission',
            outcome: dispositionOutcome,
            assessedArtifactVersionId: check.artifactVersionId ?? null
          }
        })
        touchedSourceReviewIds.add(sourceReview.id)
      }

      for (const sourceReviewId of touchedSourceReviewIds) {
        await touchReview(tx, sourceReviewId)
      }
      await tx.review.update({
        where: { id: assessmentReview.id },
        data: {
          lifecycle: 'complete',
          outcome: input.outcome,
          errorMessage: null,
          reviewerLog: JSON.stringify(input.reviewerLog ?? [])
        }
      })
      return { projectId: assessmentReview.projectId, sessionId: assessmentReview.sessionId }
    })

    const committed = (
      await this.getReviews({ projectId: ownership.projectId, sessionId: ownership.sessionId })
    ).find((review) => review.id === input.reviewId)
    if (!committed) throw new Error(`Committed Review not found: ${input.reviewId}`)
    return committed
  }

  /**
   * @deprecated Use addChecks
   */
  async addFindings(reviewId: string, findings: NewCheck[]): Promise<void> {
    return this.addChecks(reviewId, findings)
  }

  // Returns a session's reviews (newest first) each with its checks in display order.
  async getReviewsForSession(sessionId: string): Promise<ReviewWithChecks[]> {
    return this.getReviews({ sessionId })
  }

  async getReviewsForProjectSession(
    projectId: string,
    sessionId: string
  ): Promise<ReviewWithChecks[]> {
    return this.getReviews({ projectId, sessionId })
  }

  private async getReviews(where: {
    projectId?: string
    sessionId: string
  }): Promise<ReviewWithChecks[]> {
    const client = await this.getClient()
    const rows = await client.review.findMany({
      where,
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

  // Appends a fix-loop assessment without rewriting the original warning. sequence is allocated
  // inside the transaction so concurrent updates cannot produce two entries for the same position.
  async appendFindingDisposition(input: {
    eventId: string
    sourceFindingId: string
    causeReviewId?: string
    trigger: ReviewFindingDispositionTrigger
    outcome: ReviewFindingDispositionOutcome
    note?: string
    assessedArtifactVersionId?: string
  }): Promise<ReviewFindingDisposition> {
    const client = await this.getClient()
    const row = await client.$transaction(async (tx) => {
      const existing = await tx.reviewFindingDisposition.findUnique({
        where: { id: input.eventId }
      })
      if (existing) {
        if (
          existing.sourceFindingId !== input.sourceFindingId ||
          existing.causeReviewId !== (input.causeReviewId ?? null) ||
          existing.trigger !== input.trigger ||
          existing.outcome !== input.outcome ||
          existing.note !== (input.note ?? null) ||
          existing.assessedArtifactVersionId !== (input.assessedArtifactVersionId ?? null)
        ) {
          throw new Error(
            `Finding disposition event was reused with different data: ${input.eventId}`
          )
        }
        return existing
      }
      const latest = await tx.reviewFindingDisposition.findFirst({
        where: { sourceFindingId: input.sourceFindingId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true }
      })
      return tx.reviewFindingDisposition.create({
        data: {
          id: input.eventId,
          sourceFindingId: input.sourceFindingId,
          causeReviewId: input.causeReviewId ?? null,
          sequence: (latest?.sequence ?? 0) + 1,
          trigger: input.trigger,
          outcome: input.outcome,
          note: input.note ?? null,
          assessedArtifactVersionId: input.assessedArtifactVersionId ?? null
        }
      })
    })
    return {
      id: row.id,
      sourceFindingId: row.sourceFindingId,
      causeReviewId: row.causeReviewId ?? undefined,
      sequence: row.sequence,
      trigger: row.trigger as ReviewFindingDispositionTrigger,
      outcome: row.outcome as ReviewFindingDispositionOutcome,
      note: row.note ?? undefined,
      assessedArtifactVersionId: row.assessedArtifactVersionId ?? undefined,
      createdAt: row.createdAt.getTime()
    }
  }

  // Applies the fix-loop materialized state and appends its immutable audit event in one SQLite
  // transaction. Callers never update Finding.resolution/reflagCount separately from the event.
  async commitFindingDisposition(input: {
    reviewId: string
    sourceFindingId: string
    causeReviewId?: string
    trigger: ReviewFindingDispositionTrigger
    outcome: ReviewFindingDispositionOutcome
    note?: string
    assessedArtifactVersionId?: string
  }): Promise<ReviewFindingDisposition> {
    const [disposition] = await this.commitFindingDispositions([input])
    if (!disposition) throw new Error('Finding disposition was not committed.')
    return disposition
  }

  // Applies one re-review submission as a single unit. A malformed disposition must not leave the
  // earlier findings in the same submission resolved while later ones remain untouched.
  async commitFindingDispositions(
    inputs: CommitFindingDispositionInput[]
  ): Promise<ReviewFindingDisposition[]> {
    if (inputs.length === 0) return []
    const sourceFindingIds = new Set(inputs.map((input) => input.sourceFindingId))
    if (sourceFindingIds.size !== inputs.length) {
      throw new Error('A finding may only have one disposition in a single Review submission.')
    }

    const client = await this.getClient()
    const rows = await client.$transaction(async (tx) => {
      const dispositions: Array<Parameters<typeof toFindingDisposition>[0]> = []
      const reviewIds = new Set<string>()
      for (const input of inputs) {
        const finding = await tx.finding.findFirst({
          where: { id: input.sourceFindingId, reviewId: input.reviewId }
        })
        if (!finding || (finding.status !== 'warn' && finding.status !== 'fail')) {
          throw new Error(
            `Finding ${input.sourceFindingId} does not belong to review ${input.reviewId}.`
          )
        }
        const sourceReview = await tx.review.findUnique({ where: { id: input.reviewId } })
        if (!sourceReview) throw new Error(`Review not found: ${input.reviewId}`)
        const assessmentReview = input.causeReviewId
          ? await tx.review.findUnique({ where: { id: input.causeReviewId } })
          : sourceReview
        if (
          !assessmentReview ||
          assessmentReview.projectId !== sourceReview.projectId ||
          assessmentReview.sessionId !== sourceReview.sessionId
        ) {
          throw new Error('Finding disposition Review belongs to another Project or Session.')
        }
        if (input.assessedArtifactVersionId) {
          const assessmentScope = parseJson<TurnScope>(
            assessmentReview.scope,
            EMPTY_SCOPE(assessmentReview.turnMessageId)
          )
          if (!assessmentScope.artifactVersionIds.includes(input.assessedArtifactVersionId)) {
            throw new Error(
              `Assessed Artifact Version is outside Review scope: ${input.assessedArtifactVersionId}`
            )
          }
        }
        const eventId =
          input.eventId ??
          `review-disposition-${sha256(
            stableJson({
              reviewId: input.reviewId,
              sourceFindingId: input.sourceFindingId,
              causeReviewId: input.causeReviewId ?? null,
              trigger: input.trigger
            })
          )}`
        const existing = await tx.reviewFindingDisposition.findUnique({
          where: { id: eventId }
        })
        if (existing) {
          if (
            existing.sourceFindingId !== finding.id ||
            existing.causeReviewId !== (input.causeReviewId ?? null) ||
            existing.trigger !== input.trigger ||
            existing.outcome !== input.outcome ||
            existing.note !== (input.note ?? null) ||
            existing.assessedArtifactVersionId !== (input.assessedArtifactVersionId ?? null)
          ) {
            throw new Error(`Finding disposition event was reused with different data: ${eventId}`)
          }
          dispositions.push(existing)
          continue
        }
        await tx.finding.update({
          where: { id: finding.id },
          data:
            input.outcome === 'still_open'
              ? { resolution: 'open', reflagCount: { increment: 1 } }
              : { resolution: input.outcome }
        })
        const latest = await tx.reviewFindingDisposition.findFirst({
          where: { sourceFindingId: finding.id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true }
        })
        dispositions.push(
          await tx.reviewFindingDisposition.create({
            data: {
              id: eventId,
              sourceFindingId: finding.id,
              causeReviewId: input.causeReviewId ?? null,
              sequence: (latest?.sequence ?? 0) + 1,
              trigger: input.trigger,
              outcome: input.outcome,
              note: input.note ?? null,
              assessedArtifactVersionId: input.assessedArtifactVersionId ?? null
            }
          })
        )
        reviewIds.add(input.reviewId)
      }
      for (const reviewId of reviewIds) await touchReview(tx, reviewId)
      return dispositions
    })
    return rows.map(toFindingDisposition)
  }

  async getFindingDispositions(sourceFindingId: string): Promise<ReviewFindingDisposition[]> {
    const client = await this.getClient()
    const rows = await client.reviewFindingDisposition.findMany({
      where: { sourceFindingId },
      orderBy: { sequence: 'asc' }
    })
    return rows.map(toFindingDisposition)
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
export type { ReviewClient, ReviewClientProvider, ReviewRepositoryOptions, FindingSeverity }

// Legacy exports kept for callers that still reference toFinding.
export const toFinding = toCheck
