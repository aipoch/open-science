import type {
  ArtifactReproducibilityProjection,
  ArtifactReproducibilityStartFrontier,
  ArtifactReproducibilityActivity,
  ArtifactReproducibilityEntity
} from '../../../../shared/artifact-provenance'
import type { GraphNode } from './artifact-reproducibility-graph'

export type NodeStartPreview = {
  requested?: ArtifactReproducibilityStartFrontier
  effective?: ArtifactReproducibilityStartFrontier
  steps: ArtifactReproducibilityActivity[]
  dependencies: Array<{
    from?: ArtifactReproducibilityActivity
    to?: ArtifactReproducibilityActivity
  }>
  needsPreparation: boolean
  preparationIds: Set<string>
  files: ArtifactReproducibilityEntity[]
  missingFileMetadata: boolean
  missingRunMetadata: boolean
  unavailableFiles: ArtifactReproducibilityEntity[]
  noDownstream: boolean
}

// Metadata-only planning. Execution still validates the sealed frontier in main; the renderer
// never constructs a new recipe or inspects an input file to make a start appear available.
export const previewNodeStart = (
  projection: ArtifactReproducibilityProjection,
  node: GraphNode
): NodeStartPreview => {
  const activities = new Map(
    projection.activities.map((activity) => [activity.activityId, activity])
  )
  const entities = new Map(projection.entities.map((entity) => [entity.entityId, entity]))
  const runs = (
    frontier: ArtifactReproducibilityStartFrontier
  ): ArtifactReproducibilityActivity[] =>
    frontier.downstreamActivityIds
      .flatMap((id) => {
        const activity = activities.get(id)
        return activity && activity.kind !== 'artifact-publication' ? [activity] : []
      })
      .sort((a, b) => a.sequence - b.sequence || a.activityId.localeCompare(b.activityId))
  const producerIds =
    node.kind === 'activity'
      ? [node.value.activityId]
      : node.kind === 'output-group'
        ? [node.value.activityId]
        : projection.edges.flatMap((edge) =>
            edge.kind === 'generated' && edge.entityId === node.value.entityId
              ? [edge.activityId]
              : []
          )
  const original = node.kind === 'entity' && node.value.kind === 'registered-input-generation'
  const requested = projection.startFrontiers.find((frontier) =>
    original
      ? frontier.kind === 'original-inputs'
      : producerIds.length === 1 &&
        frontier.afterActivityId === producerIds[0] &&
        (node.kind === 'activity' ||
          (node.kind === 'entity'
            ? frontier.crossingEntityIds.includes(node.value.entityId)
            : node.value.memberEntityIds.some((id) => frontier.crossingEntityIds.includes(id))))
  )
  const requestedRuns = requested ? runs(requested) : []
  const hasMetadata = (frontier: ArtifactReproducibilityStartFrontier): boolean =>
    frontier.downstreamActivityIds.every((id) => activities.has(id)) &&
    frontier.crossingEntityIds.every((id) => entities.has(id)) &&
    !frontier.unavailableEntityIds?.length
  const downstream = new Set(requested?.downstreamActivityIds ?? [])
  const dependencies = projection.edges.flatMap((edge) =>
    edge.kind === 'depends-on' &&
    downstream.has(edge.activityId) &&
    !downstream.has(edge.dependencyActivityId)
      ? [{ from: activities.get(edge.dependencyActivityId), to: activities.get(edge.activityId) }]
      : []
  )
  const cutoff = requested?.afterActivityId
    ? activities.get(requested.afterActivityId)?.sequence
    : undefined
  const effective =
    requestedRuns.length === 0
      ? undefined
      : requested?.eligibility === 'available' && hasMetadata(requested)
        ? requested
        : projection.startFrontiers
            .filter((frontier) => {
              if (frontier.eligibility !== 'available' || !hasMetadata(frontier)) return false
              const sequence = frontier.afterActivityId
                ? activities.get(frontier.afterActivityId)?.sequence
                : -Infinity
              if (cutoff === undefined || sequence === undefined || sequence >= cutoff) return false
              const ids = new Set(frontier.downstreamActivityIds)
              return requested?.downstreamActivityIds.every((id) => ids.has(id))
            })
            .sort(
              (a, b) => runs(a).length - runs(b).length || a.frontierId.localeCompare(b.frontierId)
            )[0]
  const plan = effective ?? requested
  const steps = plan ? runs(plan) : []
  const requestedIds = new Set(requestedRuns.map((run) => run.activityId))
  return {
    requested,
    effective,
    steps,
    dependencies,
    needsPreparation: Boolean(effective && effective.frontierId !== requested?.frontierId),
    preparationIds: new Set(
      steps.filter((run) => !requestedIds.has(run.activityId)).map((run) => run.activityId)
    ),
    files: (plan?.crossingEntityIds ?? []).flatMap((id) => {
      const entity = entities.get(id)
      return entity ? [entity] : []
    }),
    missingFileMetadata: (plan?.crossingEntityIds ?? []).some((id) => !entities.has(id)),
    missingRunMetadata: (plan?.downstreamActivityIds ?? []).some((id) => !activities.has(id)),
    unavailableFiles: (requested?.unavailableEntityIds ?? []).flatMap((id) => {
      const entity = entities.get(id)
      return entity ? [entity] : []
    }),
    noDownstream: Boolean(requested && requestedRuns.length === 0)
  }
}
