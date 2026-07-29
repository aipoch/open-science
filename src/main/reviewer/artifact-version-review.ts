import type {
  ArtifactReviewHistoryEvent,
  ArtifactVersionReviewProjection,
  ReviewFindingDisposition,
  ReviewWithProvenanceEvidence
} from '../../shared/reviewer'

const compareReviews = (
  left: ReviewWithProvenanceEvidence,
  right: ReviewWithProvenanceEvidence
): number =>
  left.createdAt - right.createdAt ||
  left.updatedAt - right.updatedAt ||
  left.id.localeCompare(right.id)

const directlyAssesses = (review: ReviewWithProvenanceEvidence, versionId: string): boolean =>
  review.scope.artifactVersionIds.includes(versionId)

export const selectReviewChainForArtifactVersion = (input: {
  selectedVersionId: string
  versionMessageId?: string
  reviews: ReviewWithProvenanceEvidence[]
  dispositions: ReviewFindingDisposition[]
}): ArtifactVersionReviewProjection | undefined => {
  const directSeeds = input.reviews.filter((review) =>
    directlyAssesses(review, input.selectedVersionId)
  )
  const legacySeeds = input.versionMessageId
    ? input.reviews.filter((review) => review.turnMessageId === input.versionMessageId)
    : []
  const seeds = directSeeds.length > 0 ? directSeeds : legacySeeds
  if (seeds.length === 0) return undefined

  const reviewById = new Map(input.reviews.map((review) => [review.id, review]))
  const includedReviewIds = new Set(seeds.map((review) => review.id))
  const groupedTurnIds = new Set(seeds.map((review) => review.turnMessageId))
  let changed = true
  while (changed) {
    changed = false
    for (const review of input.reviews) {
      if (groupedTurnIds.has(review.turnMessageId) && !includedReviewIds.has(review.id)) {
        includedReviewIds.add(review.id)
        changed = true
      }
    }
    const includedFindingIds = new Set(
      input.reviews
        .filter((review) => includedReviewIds.has(review.id))
        .flatMap((review) => review.checks.map((check) => check.id))
    )
    for (const disposition of input.dispositions) {
      if (!includedFindingIds.has(disposition.sourceFindingId) || !disposition.causeReviewId) {
        continue
      }
      const cause = reviewById.get(disposition.causeReviewId)
      if (cause && !includedReviewIds.has(cause.id)) {
        includedReviewIds.add(cause.id)
        groupedTurnIds.add(cause.turnMessageId)
        changed = true
      }
    }
  }

  const chainReviews = input.reviews
    .filter((review) => includedReviewIds.has(review.id))
    .sort(compareReviews)
  const directReviews = chainReviews.filter((review) =>
    directlyAssesses(review, input.selectedVersionId)
  )
  const currentDirectAssessment = directReviews.at(-1)
  const assessment = currentDirectAssessment ?? chainReviews.at(-1)
  const selectedVersionChecks = (assessment?.checks ?? []).filter(
    (check) =>
      check.artifactVersionId === input.selectedVersionId &&
      (currentDirectAssessment ? check.artifactBindingState === 'scope_validated' : true)
  )
  const turnLevelChecks = (assessment?.checks ?? []).filter(
    (check) => check.artifactVersionId === undefined
  )
  const selectedFindingIds = new Set(selectedVersionChecks.map((check) => check.id))
  const selectedVersionDispositions = input.dispositions
    .filter((disposition) => selectedFindingIds.has(disposition.sourceFindingId))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id)
    )
  const chainFindingIds = new Set(
    chainReviews.flatMap((review) => review.checks.map((check) => check.id))
  )
  const history: ArtifactReviewHistoryEvent[] = [
    ...chainReviews.map((review): ArtifactReviewHistoryEvent => ({
      kind: 'review',
      review,
      directlyAssessesSelectedVersion: directlyAssesses(review, input.selectedVersionId)
    })),
    ...input.dispositions
      .filter((disposition) => chainFindingIds.has(disposition.sourceFindingId))
      .map((disposition): ArtifactReviewHistoryEvent => ({ kind: 'disposition', disposition }))
  ].sort((left, right) => {
    const leftAt = left.kind === 'review' ? left.review.createdAt : left.disposition.createdAt
    const rightAt = right.kind === 'review' ? right.review.createdAt : right.disposition.createdAt
    if (leftAt !== rightAt) return leftAt - rightAt
    const leftId = left.kind === 'review' ? left.review.id : left.disposition.id
    const rightId = right.kind === 'review' ? right.review.id : right.disposition.id
    return leftId.localeCompare(rightId)
  })

  return {
    binding: directSeeds.length > 0 ? 'version' : 'legacy-turn',
    selectedVersionId: input.selectedVersionId,
    ...(currentDirectAssessment ? { currentDirectAssessment } : {}),
    latestChainReview: chainReviews.at(-1)!,
    selectedVersionChecks,
    turnLevelChecks,
    selectedVersionDispositions,
    history
  }
}
